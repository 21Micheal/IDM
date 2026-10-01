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
            "id", "template", "order", "name", "status_label",
            "step_type",
            # approval-step fields
            "assignee_type", "assignee_group", "assignee_group_name",
            "assignee_user", "assignee_user_name", "assignee_user_auto",
            "sla_hours", "allow_resubmit",
            "allow_approve", "allow_reject", "allow_return", "allow_return_submitter",
            "requires_signature",
            "instructions",
            # custom approver email
            "approver_email_subject", "approver_email_body",
            # notification-step fields
            "notify_user", "notify_user_name", "notify_email", "notify_emails",
            "notification_subject", "notification_message",
            "notify_include_items_table", "notify_recipient_type", "notify_supplier_field",
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
            "allow_approve", "allow_reject", "allow_return", "allow_return_submitter",
            "requires_signature",
            "instructions",
            # custom approver email
            "approver_email_subject", "approver_email_body",
            # notification-step
            "notify_user", "notify_email", "notify_emails",
            "notification_subject", "notification_message",
            "notify_include_items_table", "notify_recipient_type", "notify_supplier_field",
        ]
        extra_kwargs = {
            "instructions":            {"required": False, "allow_blank": True},
            "step_type":               {"required": False},
            "approver_email_subject":  {"required": False, "allow_blank": True},
            "approver_email_body":     {"required": False, "allow_blank": True},
            "notify_email":            {"required": False, "allow_blank": True},
            "notify_emails":           {"required": False},
            "notification_subject":    {"required": False, "allow_blank": True},
            "notification_message":    {"required": False, "allow_blank": True},
            "notify_include_items_table": {"required": False},
            "notify_recipient_type":   {"required": False, "allow_blank": True},
            "notify_supplier_field":   {"required": False, "allow_null": True, "allow_blank": True},
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
            notify_emails = attrs.get("notify_emails", getattr(self.instance, "notify_emails", [])) or []
            recipient_type = (attrs.get("notify_recipient_type", getattr(self.instance, "notify_recipient_type", "email")) or "email").strip()
            supplier_field = attrs.get("notify_supplier_field", getattr(self.instance, "notify_supplier_field", None))
            subject      = (attrs.get("notification_subject", getattr(self.instance, "notification_subject", "")) or "").strip()
            message      = (attrs.get("notification_message", getattr(self.instance, "notification_message", "")) or "").strip()

            if recipient_type == "user" and not notify_user:
                raise serializers.ValidationError(
                    {"notify_user": "Notification steps with recipient type 'user' require a selected user."}
                )
            if recipient_type == "email" and not notify_user and not notify_email and not notify_emails:
                raise serializers.ValidationError(
                    {"notify_email": "Notification steps with recipient type 'email' require at least one email address."}
                )
            if recipient_type == "supplier" and not supplier_field:
                raise serializers.ValidationError(
                    {"notify_supplier_field": "Notification steps with recipient type 'supplier' require a supplier field selection."}
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
            attrs["allow_return_submitter"] = False
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
        allow_return_submitter = attrs.get(
            "allow_return_submitter",
            getattr(self.instance, "allow_return_submitter", True),
        )
        requires_signature = attrs.get("requires_signature", getattr(self.instance, "requires_signature", False))

        if not any([allow_approve, allow_reject, allow_return, allow_return_submitter]):
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
            "id", "name", "description", "target_type", "document_type", "document_type_name", "is_active",
            "notify_uploader_on_approval", "email_templates", "definition",
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
    retire_siblings = serializers.BooleanField(
        required=False,
        write_only=True,
        default=False,
        help_text=(
            "When saving a v2 branched definition, deactivate other templates for "
            "the same document type, remove their routing rules, and point the "
            "document type at this template."
        ),
    )

    class Meta:
        model  = WorkflowTemplate
        fields = [
            "name", "description", "target_type", "document_type", "is_active",
            "notify_uploader_on_approval", "email_templates", "definition", "steps",
            "retire_siblings",
        ]
        extra_kwargs = {
            "is_active":                    {"required": False},
            "target_type":                  {"required": False},
            "document_type":                {"required": False, "allow_null": True},
            "notify_uploader_on_approval":  {"required": False},
            "email_templates":              {"required": False},
            "definition":                   {"required": False, "allow_null": True},
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
        target_type = attrs.get("target_type", getattr(self.instance, "target_type", "document")) or "document"
        document_type = attrs.get("document_type", getattr(self.instance, "document_type", None))

        if target_type == "payment_run":
            attrs["document_type"] = None
        elif document_type is None:
            raise serializers.ValidationError(
                {"document_type": "Choose the document type this template belongs to."}
            )

        if target_type == "document" and document_type is None and self.instance and self.instance.rules.exists():
            raise serializers.ValidationError(
                {"document_type": "Templates with routing rules must remain assigned to a document type."}
            )

        raw_templates = attrs.get("email_templates")
        if raw_templates is not None and not isinstance(raw_templates, dict):
            raise serializers.ValidationError(
                {"email_templates": "Email templates must be a JSON object."}
            )

        # Validate v2 workflow definition if present
        definition = attrs.get("definition")
        if definition is not None:
            if not isinstance(definition, dict):
                raise serializers.ValidationError(
                    {"definition": "Workflow definition must be a JSON object."}
                )
            if definition.get("version") != 2:
                raise serializers.ValidationError(
                    {"definition": "Workflow definition must have version 2."}
                )

            try:
                from .engine import validate_definition, build_field_map_from_document_type

                field_map = {}
                doc_type_obj = None
                if document_type is not None:
                    if hasattr(document_type, "pk"):
                        doc_type_obj = document_type
                    else:
                        from apps.documents.models import DocumentType
                        try:
                            doc_type_obj = DocumentType.objects.get(pk=document_type)
                        except (DocumentType.DoesNotExist, ValueError, TypeError):
                            try:
                                doc_type_obj = DocumentType.objects.get(name=document_type)
                            except DocumentType.DoesNotExist:
                                doc_type_obj = None

                if doc_type_obj is not None:
                    field_map = build_field_map_from_document_type(doc_type_obj)

                validation_errors = validate_definition(definition, field_map)
                if validation_errors:
                    error_messages = [e.message for e in validation_errors if e.severity == "error"]
                    if error_messages:
                        raise serializers.ValidationError(
                            {"definition": f"Workflow definition validation failed: {', '.join(error_messages)}"}
                        )
            except serializers.ValidationError:
                raise
            except Exception as e:
                # If validation fails for any reason (e.g. import error, database error),
                # log it but don't block the save — the definition may still be valid.
                import logging
                logger = logging.getLogger(__name__)
                logger.warning(f"Workflow definition validation skipped due to error: {e}")

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
            if target_type == "payment_run" and any(s.get("requires_signature") for s in steps_data):
                raise serializers.ValidationError(
                    {"steps": "Payment run workflow steps cannot require document signatures."}
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

        # For v2 workflows, steps are a flat mirror of the definition. Relax deletion
        # protection so templates with live tasks can still be edited; only orphans
        # without tasks are removed.
        is_v2 = bool(template.definition and template.definition.get("version") == 2)

        if removed_step_ids and not is_v2:
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

        # Always park existing rows on temporary high orders first. Skipping this
        # for v2 caused IntegrityError on (template_id, order) when importing rules
        # (new steps written as order=1..n while old rows still held those orders).
        # Must stay non-negative: order is a PositiveSmallIntegerField.
        for idx, step in enumerate(existing_steps):
            WorkflowStep.objects.filter(pk=step.pk).update(order=20000 + idx)
            step.order = 20000 + idx

        if removed_step_ids and not is_v2:
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

        if is_v2 and removed_step_ids:
            deletable_ids = list(
                WorkflowStep.objects.filter(
                    id__in=removed_step_ids,
                    workflowtask__isnull=True,
                ).values_list("id", flat=True)
            )
            if deletable_ids:
                WorkflowStep.objects.filter(id__in=deletable_ids).delete()

            # Protected orphans keep their FK history but must leave the temp
            # park zone so future upserts stay collision-free.
            leftover = list(
                WorkflowStep.objects.filter(template=template, order__gte=20000).order_by("order")
            )
            if leftover:
                for offset, step in enumerate(leftover, start=1):
                    step.order = 25000 + offset
                    step.save(update_fields=["order"])

    @staticmethod
    def _retire_sibling_templates(template: WorkflowTemplate) -> int:
        """
        Make *template* the sole active workflow for its document type (or for
        payment_run target). Deactivates siblings, deletes their routing rules
        and this template's legacy rules, and points the document type here.
        Returns how many sibling templates were retired.
        """
        # Branched definitions replace amount/phase routing rules.
        template.rules.all().delete()

        if template.target_type == "payment_run":
            siblings = (
                WorkflowTemplate.objects
                .filter(target_type="payment_run", is_active=True)
                .exclude(pk=template.pk)
            )
        elif template.document_type_id:
            siblings = (
                WorkflowTemplate.objects
                .filter(
                    target_type="document",
                    document_type_id=template.document_type_id,
                    is_active=True,
                )
                .exclude(pk=template.pk)
            )
        else:
            siblings = WorkflowTemplate.objects.none()

        retired = 0
        for sibling in siblings:
            sibling.rules.all().delete()
            sibling.is_active = False
            sibling.save(update_fields=["is_active", "updated_at"])
            retired += 1

        if template.document_type_id:
            from apps.documents.models import DocumentType
            DocumentType.objects.filter(pk=template.document_type_id).update(
                workflow_template_id=template.pk,
            )

        return retired

    @transaction.atomic
    def create(self, validated_data):
        steps_data = validated_data.pop("steps", [])
        retire_siblings = validated_data.pop("retire_siblings", False)
        template = WorkflowTemplate.objects.create(**validated_data)
        self._upsert_steps(template, steps_data)
        if retire_siblings and template.definition and template.definition.get("version") == 2:
            self._retire_sibling_templates(template)
        return template

    @transaction.atomic
    def update(self, instance, validated_data):
        steps_data = validated_data.pop("steps", None)
        retire_siblings = validated_data.pop("retire_siblings", False)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if steps_data is not None:
            self._upsert_steps(instance, steps_data)
        if retire_siblings and instance.definition and instance.definition.get("version") == 2:
            self._retire_sibling_templates(instance)
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
            "id", "target_type", "document_type", "document_type_name",
            "template", "template_name",
            "template_document_type",
            "phase", "amount_min", "amount_max", "currency", "label", "is_active",
        ]
        read_only_fields = ["id", "target_type", "document_type", "template_name", "document_type_name", "template_document_type"]
        extra_kwargs = {
            "phase":     {"required": False, "allow_blank": True},
            "label":     {"required": False, "allow_blank": True},
            "is_active": {"required": False},
        }

    def validate(self, attrs):
        template   = attrs.get("template",   getattr(self.instance, "template",   None))
        amount_min = attrs.get("amount_min", getattr(self.instance, "amount_min", 0))
        amount_max = attrs.get("amount_max", getattr(self.instance, "amount_max", None))
        currency   = (attrs.get("currency",  getattr(self.instance, "currency",   "USD")) or "USD").upper()
        phase      = (attrs.get("phase", getattr(self.instance, "phase", WorkflowRule.DEFAULT_PHASE)) or WorkflowRule.DEFAULT_PHASE).strip().lower()

        if template is None:
            raise serializers.ValidationError({"template": "A template is required."})

        target_type = template.target_type
        document_type = template.document_type
        if target_type == "document" and document_type is None:
            raise serializers.ValidationError(
                {"template": "Assign this template to a document type before adding routing rules."}
            )

        if amount_max is not None and amount_max < amount_min:
            raise serializers.ValidationError({"amount_max": "Maximum amount must be greater than or equal to minimum amount."})

        overlaps = (
            WorkflowRule.objects
            .filter(
                target_type=target_type,
                document_type=document_type,
                template__target_type=target_type,
                template__document_type=document_type,
                phase=phase,
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
        attrs["target_type"] = target_type
        attrs["currency"] = currency
        attrs["phase"] = phase
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
    target_type = serializers.CharField(source="workflow_instance.target_type", read_only=True)
    document_id = serializers.SerializerMethodField()
    document_ref = serializers.SerializerMethodField()
    document_title = serializers.SerializerMethodField()
    document_type_name = serializers.SerializerMethodField()
    document_department_name = serializers.SerializerMethodField()
    payment_run_id = serializers.SerializerMethodField()
    payment_reference = serializers.SerializerMethodField()
    payment_run_status = serializers.SerializerMethodField()
    payment_run_total = serializers.SerializerMethodField()
    payment_run_currency_codes = serializers.SerializerMethodField()
    payment_run_lines = serializers.SerializerMethodField()
    uploaded_by_name = serializers.SerializerMethodField()
    uploader_department_name = serializers.SerializerMethodField()
    file_name = serializers.SerializerMethodField()
    file_mime_type = serializers.SerializerMethodField()
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    requires_signature = serializers.SerializerMethodField()
    is_delegated = serializers.SerializerMethodField()
    delegated_from = serializers.SerializerMethodField()

    def _document(self, obj):
        return getattr(obj.workflow_instance, "document", None)

    def _payment_run(self, obj):
        return getattr(obj.workflow_instance, "payment_run", None)

    def get_document_id(self, obj):
        doc = self._document(obj)
        return str(doc.id) if doc else None

    def get_document_ref(self, obj):
        doc = self._document(obj)
        if doc:
            return doc.reference_number
        run = self._payment_run(obj)
        return run.payment_reference if run else ""

    def get_document_title(self, obj):
        doc = self._document(obj)
        if doc:
            return doc.title
        run = self._payment_run(obj)
        return f"Payment Run {run.payment_reference}" if run else ""

    def get_document_type_name(self, obj):
        doc = self._document(obj)
        if doc and doc.document_type_id:
            return doc.document_type.name
        return "Payment run" if self._payment_run(obj) else ""

    def get_document_department_name(self, obj):
        doc = self._document(obj)
        return doc.department.name if doc and doc.department_id else None

    def get_payment_run_id(self, obj):
        run = self._payment_run(obj)
        return str(run.id) if run else None

    def get_payment_reference(self, obj):
        run = self._payment_run(obj)
        return run.payment_reference if run else None

    def get_payment_run_status(self, obj):
        run = self._payment_run(obj)
        return run.status if run else None

    def get_payment_run_total(self, obj):
        run = self._payment_run(obj)
        return str(run.total_amount) if run else None

    def get_payment_run_currency_codes(self, obj):
        run = self._payment_run(obj)
        return run.currency_codes if run else []

    def get_payment_run_lines(self, obj):
        run = self._payment_run(obj)
        if not run:
            return []
        lines = run.lines if isinstance(run.lines, list) else []
        allowed = {
            "account_code",
            "account_description",
            "accounting_period",
            "transaction_date",
            "journal_number",
            "journal_line_number",
            "transaction_reference",
            "description",
            "base_amount",
            "conversion_rate",
            "currency_code",
            "transaction_amount",
            "debit_credit",
            "allocation_marker",
            "payment_marker",
        }
        return [
            {key: value for key, value in line.items() if key in allowed}
            for line in lines
            if isinstance(line, dict)
        ]

    def get_uploaded_by_name(self, obj):
        doc = self._document(obj)
        uploader = doc.uploaded_by if doc else getattr(self._payment_run(obj), "submitted_by", None)
        if not uploader:
            return None
        return uploader.get_full_name() or uploader.email

    def get_uploader_department_name(self, obj):
        doc = self._document(obj)
        uploader = doc.uploaded_by if doc else getattr(self._payment_run(obj), "submitted_by", None)
        return uploader.department.name if uploader and uploader.department_id else None

    def get_file_name(self, obj):
        doc = self._document(obj)
        return doc.file_name if doc else ""

    def get_file_mime_type(self, obj):
        doc = self._document(obj)
        return doc.file_mime_type if doc else ""

    def get_requires_signature(self, obj):
        if not self._document(obj):
            return False
        return bool(obj.step.requires_signature)

    def get_is_delegated(self, obj):
        request = self.context.get("request")
        if not request or not getattr(request.user, "is_authenticated", False):
            return False
        from apps.accounts.delegation import user_can_action_task_via_delegation
        return user_can_action_task_via_delegation(request.user, obj)

    def get_delegated_from(self, obj):
        if not self.get_is_delegated(obj):
            return None
        return UserSummarySerializer(obj.assigned_to).data

    class Meta:
        model  = WorkflowTask
        fields = [
            "id", "step", "assigned_to",
            "status", "status_display",
            "requires_signature",
            "comment", "held_until",
            "due_at", "acted_at",
            "target_type",
            "document_id", "document_ref", "document_title", "document_type_name",
            "payment_run_id", "payment_reference", "payment_run_status", "payment_run_total",
            "payment_run_currency_codes", "payment_run_lines",
            "document_department_name", "uploaded_by_name", "uploader_department_name",
            "file_name", "file_mime_type",
            "is_delegated", "delegated_from",
        ]


class WorkflowInstanceSerializer(serializers.ModelSerializer):
    tasks      = WorkflowTaskSerializer(many=True, read_only=True)
    started_by = UserSummarySerializer(read_only=True)
    rule_label = serializers.CharField(source="rule.label", read_only=True, default="")
    phase = serializers.SerializerMethodField()

    class Meta:
        model  = WorkflowInstance
        fields = [
            "id", "target_type", "document", "payment_run", "template", "rule", "rule_label",
            "phase",
            "status", "current_step_order",
            "definition_version", "current_node_id",
            "started_by", "started_at", "completed_at", "tasks",
        ]

    def get_phase(self, obj):
        if obj.rule_id and obj.rule and obj.rule.phase:
            return obj.rule.phase
        if obj.target_type == "payment_run":
            return "payment_run"
        return "request"
