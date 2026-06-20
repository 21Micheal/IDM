"""
apps/workflows/serializers.py
Adds:
  - step_type, notify_user, notify_email, notification_subject, notification_message
    on WorkflowStepSerializer / WorkflowStepWriteSerializer
  - approver_email_subject, approver_email_body on WorkflowStepSerializer /
    WorkflowStepWriteSerializer (custom email override for approval steps)
  - Relaxed validation: notification steps skip assignee_group requirement.
Everything else unchanged from previous version.
"""
from rest_framework import serializers
from django.db.models import Q
from django.db import transaction
from django.utils import timezone
from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
import uuid

from .models import (
    WorkflowTemplate, WorkflowStep, WorkflowRule,
    WorkflowInstance, WorkflowTask, WorkflowTaskAction, DocumentSignature,
)
from apps.accounts.models import UserGroup
from apps.accounts.serializers import UserSummarySerializer

User = get_user_model()

LEGACY_ASSIGNEE_TYPE_MAP = {
    "any_role": "group_any",
    "group_member": "group_any",
    "group_hod": "group_all",
    "specific_user": "group_specific",
}


def normalize_assignee_type(value):
    if value in LEGACY_ASSIGNEE_TYPE_MAP:
        return LEGACY_ASSIGNEE_TYPE_MAP[value]
    return value


def is_uuid_like(value):
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except (TypeError, ValueError, AttributeError):
        return False
    return True


class FlexibleGroupField(serializers.PrimaryKeyRelatedField):
    """
    Accept a UUID, a UserGroup instance, or a legacy group name string.
    """
    def to_internal_value(self, data):
        if data in (None, ""):
            return None
        if isinstance(data, UserGroup):
            return data
        if isinstance(data, str) and not is_uuid_like(data):
            match = self.get_queryset().filter(name__iexact=data.strip()).first()
            if match:
                return match
        return super().to_internal_value(data)


class FlexibleUserField(serializers.PrimaryKeyRelatedField):
    """
    Accept a UUID, a User instance, or blank-ish legacy values.
    """
    def to_internal_value(self, data):
        if data in (None, ""):
            return None
        if isinstance(data, User):
            return data
        if isinstance(data, str) and not is_uuid_like(data):
            return None
        return super().to_internal_value(data)


class WorkflowStepSerializer(serializers.ModelSerializer):
    assignee_type = serializers.SerializerMethodField()
    assignee_group = serializers.SerializerMethodField()
    assignee_group_name = serializers.SerializerMethodField()
    assignee_user = serializers.SerializerMethodField()
    assignee_user_name = serializers.SerializerMethodField()
    notify_user_name = serializers.SerializerMethodField()

    class Meta:
        model  = WorkflowStep
        fields = [
            "id", "order", "name", "status_label",
            "step_type",
            # approval-step fields
            "assignee_type", "assignee_group", "assignee_group_name",
            "assignee_user", "assignee_user_name", "assignee_user_auto",
            "sla_hours", "allow_resubmit",
            "allow_approve", "allow_reject", "allow_return",
            "requires_signature",
            "instructions",
            # custom approver email
            "approver_email_subject", "approver_email_body",
            # notification-step fields
            "notify_user", "notify_user_name", "notify_email",
            "notification_subject", "notification_message",
        ]

    def get_assignee_type(self, obj):
        return normalize_assignee_type(obj.assignee_type)

    def get_assignee_group(self, obj):
        try:
            return str(obj.assignee_group_id) if obj.assignee_group_id else None
        except ObjectDoesNotExist:
            return None

    def get_assignee_group_name(self, obj):
        try:
            return obj.assignee_group.name if obj.assignee_group_id and obj.assignee_group else None
        except ObjectDoesNotExist:
            return None

    def get_assignee_user(self, obj):
        try:
            return str(obj.assignee_user_id) if obj.assignee_user_id else None
        except ObjectDoesNotExist:
            return None

    def get_assignee_user_name(self, obj):
        try:
            if obj.assignee_user_id and obj.assignee_user:
                return obj.assignee_user.get_full_name() or obj.assignee_user.email
        except ObjectDoesNotExist:
            return None
        return None

    def get_notify_user_name(self, obj):
        try:
            if obj.notify_user_id and obj.notify_user:
                return obj.notify_user.get_full_name() or obj.notify_user.email
        except ObjectDoesNotExist:
            return None
        return None


class WorkflowStepWriteSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(required=False)
    assignee_type = serializers.CharField(default="group_any")
    assignee_group = FlexibleGroupField(
        queryset=UserGroup.objects.filter(is_active=True),
        required=False,
        allow_null=True,
    )
    assignee_user = FlexibleUserField(
        queryset=User.objects.filter(is_active=True),
        required=False,
        allow_null=True,
    )
    notify_user = FlexibleUserField(
        queryset=User.objects.filter(is_active=True),
        required=False,
        allow_null=True,
    )

    class Meta:
        model  = WorkflowStep
        fields = [
            "id", "name", "status_label",
            "step_type",
            # approval-step
            "assignee_type", "assignee_group", "assignee_user", "assignee_user_auto",
            "sla_hours", "allow_resubmit",
            "allow_approve", "allow_reject", "allow_return",
            "requires_signature",
            "instructions",
            # custom approver email
            "approver_email_subject", "approver_email_body",
            # notification-step
            "notify_user", "notify_email",
            "notification_subject", "notification_message",
        ]
        extra_kwargs = {
            "instructions":            {"required": False, "allow_blank": True},
            "step_type":               {"required": False},
            "approver_email_subject":  {"required": False, "allow_blank": True},
            "approver_email_body":     {"required": False, "allow_blank": True},
            "notify_email":            {"required": False, "allow_blank": True},
            "notification_subject":    {"required": False, "allow_blank": True},
            "notification_message":    {"required": False, "allow_blank": True},
        }

    def to_internal_value(self, data):
        UserGroup.ensure_hod_group()
        mutable = dict(data)
        mutable["assignee_type"] = normalize_assignee_type(mutable.get("assignee_type", "group_any"))
        return super().to_internal_value(mutable)

    def validate(self, attrs):
        step_type = attrs.get("step_type", getattr(self.instance, "step_type", "approval")) or "approval"

        # ── Notification step validation ──────────────────────────────────────
        if step_type == "notification":
            notify_user  = attrs.get("notify_user",  getattr(self.instance, "notify_user",  None))
            notify_email = (attrs.get("notify_email", getattr(self.instance, "notify_email", "")) or "").strip()
            subject      = (attrs.get("notification_subject", getattr(self.instance, "notification_subject", "")) or "").strip()
            message      = (attrs.get("notification_message", getattr(self.instance, "notification_message", "")) or "").strip()

            if not notify_user and not notify_email:
                raise serializers.ValidationError(
                    {"notify_user": "Notification steps require either a recipient user or an email address."}
                )
            if not subject:
                raise serializers.ValidationError(
                    {"notification_subject": "A subject is required for notification steps."}
                )
            if not message:
                raise serializers.ValidationError(
                    {"notification_message": "A message body is required for notification steps."}
                )
            # Notification steps don't need approval semantics — clear them
            attrs.setdefault("assignee_group", None)
            attrs.setdefault("assignee_user", None)
            attrs["allow_approve"]       = False
            attrs["allow_reject"]        = False
            attrs["allow_return"]        = False
            attrs["allow_resubmit"]      = False
            attrs["requires_signature"]  = False
            attrs["assignee_user_auto"]  = False
            return attrs

        # ── Approval step validation ──────────────────────────────────────────
        assignee_type  = attrs.get("assignee_type", getattr(self.instance, "assignee_type", None))
        assignee_group = attrs.get("assignee_group", getattr(self.instance, "assignee_group", None))
        assignee_user  = attrs.get("assignee_user",  getattr(self.instance, "assignee_user",  None))

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
            if not UserGroup.objects.filter(
                id=assignee_group.id,
                memberships__user__id=assignee_user.id,
                is_active=True,
            ).filter(
                Q(memberships__expires_at__isnull=True) |
                Q(memberships__expires_at__gt=timezone.now())
            ).exists():
                raise serializers.ValidationError(
                    {"assignee_user": "The selected user is not an active member of the selected group."}
                )

        allow_approve      = attrs.get("allow_approve",      getattr(self.instance, "allow_approve",      True))
        allow_reject       = attrs.get("allow_reject",       getattr(self.instance, "allow_reject",       True))
        allow_return       = attrs.get("allow_return",       getattr(self.instance, "allow_return",       True))
        requires_signature = attrs.get("requires_signature", getattr(self.instance, "requires_signature", False))

        if not any([allow_approve, allow_reject, allow_return]):
            raise serializers.ValidationError(
                {"allow_approve": "At least one approver action (approve, reject, or send back) must be enabled."}
            )
        if requires_signature and not allow_approve:
            raise serializers.ValidationError(
                {"requires_signature": "A signature can only be required when approval is allowed."}
            )

        return attrs


class WorkflowTemplateSerializer(serializers.ModelSerializer):
    steps      = WorkflowStepSerializer(many=True, read_only=True)
    step_count = serializers.SerializerMethodField()
    created_by = UserSummarySerializer(read_only=True)
    document_type_name = serializers.CharField(source="document_type.name", read_only=True, default=None)

    class Meta:
        model  = WorkflowTemplate
        fields = [
            "id", "name", "description", "document_type", "document_type_name", "is_active",
            "notify_uploader_on_approval", "email_templates",
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
        fields = ["name", "description", "document_type", "is_active", "notify_uploader_on_approval", "email_templates", "steps"]
        extra_kwargs = {
            "is_active":                    {"required": False},
            "document_type":                {"required": False, "allow_null": True},
            "notify_uploader_on_approval":  {"required": False},
            "email_templates":              {"required": False},
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

    def validate(self, attrs):
        attrs = super().validate(attrs)
        document_type = attrs.get("document_type", getattr(self.instance, "document_type", None))

        if document_type is None and self.instance and self.instance.rules.exists():
            raise serializers.ValidationError(
                {"document_type": "Templates with routing rules must remain assigned to a document type."}
            )

        raw_templates = attrs.get("email_templates")
        if raw_templates is not None and not isinstance(raw_templates, dict):
            raise serializers.ValidationError(
                {"email_templates": "Email templates must be a JSON object."}
            )

        # Require at least one approval step (notification-only templates make no sense)
        steps_data = attrs.get("steps")
        if steps_data is not None:
            has_approval = any(
                (s.get("step_type") or "approval") == "approval"
                for s in steps_data
            )
            if not has_approval:
                raise serializers.ValidationError(
                    {"steps": "A workflow template must have at least one approval step."}
                )

        return attrs

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
    document_type = serializers.PrimaryKeyRelatedField(read_only=True)
    template = serializers.PrimaryKeyRelatedField(queryset=WorkflowTemplate.objects.filter(is_active=True))
    template_name      = serializers.CharField(source="template.name", read_only=True)
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)
    template_document_type = serializers.UUIDField(source="template.document_type_id", read_only=True)
    amount_min = serializers.DecimalField(max_digits=18, decimal_places=2)
    amount_max = serializers.DecimalField(max_digits=18, decimal_places=2, allow_null=True, required=False)

    class Meta:
        model  = WorkflowRule
        fields = [
            "id", "document_type", "document_type_name",
            "template", "template_name",
            "template_document_type",
            "amount_min", "amount_max", "currency", "label", "is_active",
        ]
        read_only_fields = ["id", "document_type", "template_name", "document_type_name", "template_document_type"]
        extra_kwargs = {
            "label":     {"required": False, "allow_blank": True},
            "is_active": {"required": False},
        }

    def validate(self, attrs):
        template   = attrs.get("template",   getattr(self.instance, "template",   None))
        amount_min = attrs.get("amount_min", getattr(self.instance, "amount_min", 0))
        amount_max = attrs.get("amount_max", getattr(self.instance, "amount_max", None))
        currency   = (attrs.get("currency",  getattr(self.instance, "currency",   "USD")) or "USD").upper()

        if template is None:
            raise serializers.ValidationError({"template": "A template is required."})

        document_type = template.document_type
        if document_type is None:
            raise serializers.ValidationError(
                {"template": "Assign this template to a document type before adding routing rules."}
            )

        if amount_max is not None and amount_max < amount_min:
            raise serializers.ValidationError({"amount_max": "Maximum amount must be greater than or equal to minimum amount."})

        overlaps = (
            WorkflowRule.objects
            .filter(
                document_type=document_type,
                template__document_type=document_type,
                currency=currency,
                is_active=True,
            )
            .exclude(pk=getattr(self.instance, "pk", None))
        )
        for rule in overlaps:
            other_min = rule.amount_min
            other_max = rule.amount_max
            a_reaches_b = other_max is None or amount_min <= other_max
            b_reaches_a = amount_max is None or other_min <= amount_max
            if a_reaches_b and b_reaches_a:
                raise serializers.ValidationError(
                    {"amount_min": f"This amount range overlaps with rule '{rule.label or rule.template.name}'."}
                )

        attrs["document_type"] = document_type
        attrs["currency"] = currency
        return attrs


class WorkflowTaskActionSerializer(serializers.ModelSerializer):
    """Serializes the immutable action history log for a task."""
    actor             = UserSummarySerializer(read_only=True)
    action_display    = serializers.CharField(source="get_action_display", read_only=True)
    return_to         = serializers.CharField(read_only=True)
    return_to_display = serializers.CharField(source="get_return_to_display", read_only=True)

    class Meta:
        model  = WorkflowTaskAction
        fields = [
            "id", "action", "action_display", "return_to", "return_to_display",
            "actor", "comment", "hold_hours", "created_at",
        ]


class DocumentSignatureSerializer(serializers.ModelSerializer):
    signer = UserSummarySerializer(read_only=True)
    step_name = serializers.CharField(source="task.step.name", read_only=True)
    signed_version_number = serializers.IntegerField(source="signed_version.version_number", read_only=True)

    class Meta:
        model = DocumentSignature
        fields = [
            "id", "signer", "step_name", "signed_version", "signed_version_number",
            "page_number", "checksum", "signed_at",
        ]


class WorkflowTaskSerializer(serializers.ModelSerializer):
    step           = WorkflowStepSerializer(read_only=True)
    assigned_to    = UserSummarySerializer(read_only=True)
    document_id    = serializers.CharField(source="workflow_instance.document.id",               read_only=True)
    document_ref   = serializers.CharField(source="workflow_instance.document.reference_number", read_only=True)
    document_title = serializers.CharField(source="workflow_instance.document.title",            read_only=True)
    document_type_name = serializers.CharField(source="workflow_instance.document.document_type.name", read_only=True)
    document_department_name = serializers.CharField(source="workflow_instance.document.department.name", read_only=True, default=None)
    uploaded_by_name = serializers.SerializerMethodField()
    uploader_department_name = serializers.CharField(source="workflow_instance.document.uploaded_by.department.name", read_only=True, default=None)
    file_name = serializers.CharField(source="workflow_instance.document.file_name", read_only=True)
    file_mime_type = serializers.CharField(source="workflow_instance.document.file_mime_type", read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    requires_signature = serializers.BooleanField(source="step.requires_signature", read_only=True)

    def get_uploaded_by_name(self, obj):
        uploader = obj.workflow_instance.document.uploaded_by
        return uploader.get_full_name() or uploader.email

    class Meta:
        model  = WorkflowTask
        fields = [
            "id", "step", "assigned_to",
            "status", "status_display",
            "requires_signature",
            "comment", "held_until",
            "due_at", "acted_at",
            "document_id", "document_ref", "document_title", "document_type_name",
            "document_department_name", "uploaded_by_name", "uploader_department_name",
            "file_name", "file_mime_type",
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