from django.core.exceptions import ObjectDoesNotExist
from rest_framework import serializers

from .models import JournalPosting, PaymentRun, PaymentRunApproval, PaymentRunStatus


class JournalPostingSerializer(serializers.ModelSerializer):
    document_id = serializers.UUIDField(source="document.id", read_only=True)
    posted_by_name = serializers.SerializerMethodField()

    class Meta:
        model = JournalPosting
        fields = [
            "id", "document_id", "stage", "stage_label",
            "status", "attempts",
            "component", "method", "business_unit",
            "journal_number", "message", "error",
            "request_xml", "response_xml",
            "posted_at", "posted_by_name", "created_at", "updated_at",
        ]
        read_only_fields = fields

    def get_posted_by_name(self, obj):
        user = obj.posted_by
        if not user:
            return None
        return user.get_full_name() or user.email


class PaymentRunApprovalSerializer(serializers.ModelSerializer):
    approved_by_name = serializers.SerializerMethodField()

    class Meta:
        model = PaymentRunApproval
        fields = ["id", "stage", "approved_by_name", "approved_at", "note"]
        read_only_fields = fields

    def get_approved_by_name(self, obj):
        user = obj.approved_by
        if not user:
            return None
        return user.get_full_name() or user.email


def _payment_run_workflow(obj: PaymentRun):
    # Reverse OneToOne raises RelatedObjectDoesNotExist when unset.
    try:
        return obj.workflow_instance
    except ObjectDoesNotExist:
        return None


def _approval_template_steps(workflow):
    if not workflow or not workflow.template_id:
        return []
    steps = list(getattr(workflow.template, "_prefetched_objects_cache", {}).get("steps") or [])
    if not steps:
        steps = list(workflow.template.steps.all())
    return [s for s in steps if getattr(s, "step_type", "approval") == "approval"]


class PaymentRunSerializer(serializers.ModelSerializer):
    submitted_by_name = serializers.SerializerMethodField()
    processed_by_name = serializers.SerializerMethodField()
    # Prefer workflow-builder approval steps over the legacy PaymentRunApproval table.
    required_approvals = serializers.SerializerMethodField()
    approval_count = serializers.SerializerMethodField()
    approvals = PaymentRunApprovalSerializer(many=True, read_only=True)
    status_display = serializers.SerializerMethodField()
    current_step_name = serializers.SerializerMethodField()
    current_step_status_label = serializers.SerializerMethodField()
    workflow_instance_id = serializers.SerializerMethodField()
    # Overlay current post-payment marker for paid runs (historical F → P).
    lines = serializers.SerializerMethodField()

    class Meta:
        model = PaymentRun
        fields = [
            "id", "payment_reference", "reference_prefix", "run_date",
            "daily_sequence", "business_unit", "budget_code", "status",
            "status_display", "current_step_name", "current_step_status_label",
            "workflow_instance_id",
            "required_approvals", "approval_count", "line_count",
            "total_amount", "currency_codes", "lines", "component", "method",
            "bank_details_code", "discount_account_credit", "profile_code",
            "document_format_code", "request_xml", "response_xml", "error",
            "submitted_by_name", "processed_by_name", "submitted_at",
            "updated_at", "processed_at", "approvals",
        ]
        read_only_fields = fields

    def get_submitted_by_name(self, obj):
        user = obj.submitted_by
        if not user:
            return None
        return user.get_full_name() or user.email

    def get_processed_by_name(self, obj):
        user = obj.processed_by
        if not user:
            return None
        return user.get_full_name() or user.email

    def get_lines(self, obj):
        lines = obj.lines or []
        if obj.status != PaymentRunStatus.PAID:
            return lines
        from .payment_run import _lines_with_paid_markers
        return _lines_with_paid_markers(lines)

    def get_workflow_instance_id(self, obj):
        workflow = _payment_run_workflow(obj)
        return str(workflow.id) if workflow else None

    def get_required_approvals(self, obj):
        workflow = _payment_run_workflow(obj)
        steps = _approval_template_steps(workflow)
        if steps:
            return len(steps)
        return int(obj.required_approvals or 0)

    def get_approval_count(self, obj):
        workflow = _payment_run_workflow(obj)
        steps = _approval_template_steps(workflow)
        if not workflow or not steps:
            return obj.approvals.count()

        if workflow.status == "approved":
            return len(steps)

        completed_orders = {
            t.step.order
            for t in workflow.tasks.all()
            if t.step_id
            and getattr(t.step, "step_type", "approval") == "approval"
            and t.status == "approved"
        }
        if workflow.status in ("rejected", "cancelled"):
            return sum(1 for s in steps if s.order in completed_orders)

        # In progress: approval steps before the current order are complete.
        current = workflow.current_step_order or 1
        return min(
            sum(1 for s in steps if s.order < current or s.order in completed_orders),
            len(steps),
        )

    def _current_step(self, obj):
        workflow = _payment_run_workflow(obj)
        if not workflow or workflow.status != "in_progress":
            return None
        steps = list(getattr(workflow.template, "_prefetched_objects_cache", {}).get("steps") or [])
        if not steps:
            steps = list(workflow.template.steps.all())
        order = workflow.current_step_order or 1
        return next((s for s in steps if s.order == order), None)

    def get_current_step_name(self, obj):
        step = self._current_step(obj)
        if not step:
            return None
        return (step.name or "").strip() or None

    def get_current_step_status_label(self, obj):
        step = self._current_step(obj)
        if not step:
            return None
        label = (step.status_label or "").strip()
        name = (step.name or "").strip()
        # Prefer a customized status_label; fall back to the step name when the
        # builder left the generic default ("Pending Approval").
        if label and label.lower() not in {"pending approval", "pending"}:
            return label
        if name:
            if name.lower().startswith("pending"):
                return name
            return f"Pending — {name}"
        return label or None

    def get_status_display(self, obj):
        if obj.status == PaymentRunStatus.PENDING_APPROVAL:
            return (
                self.get_current_step_status_label(obj)
                or self.get_current_step_name(obj)
                or "Pending approval"
            )
        if obj.status == PaymentRunStatus.REJECTED:
            return "Rejected"
        if obj.status in (PaymentRunStatus.APPROVED, PaymentRunStatus.PROCESSING):
            return "Processing payment"
        if obj.status == PaymentRunStatus.PAID:
            return "Paid"
        if obj.status == PaymentRunStatus.FAILED:
            return "Failed"
        return obj.get_status_display()


class BudgetCheckRequestSerializer(serializers.Serializer):
    template_id = serializers.UUIDField(required=False)
    document_id = serializers.UUIDField(required=False)
    # The live, unsaved form values from the fill UI.
    values = serializers.DictField(required=False)
    # Inline budget mapping (builder preview); falls back to the template/document.
    mapping = serializers.DictField(required=False)


class JournalPreviewRequestSerializer(serializers.Serializer):
    template_id = serializers.UUIDField(required=False)
    document_id = serializers.UUIDField(required=False)
    # Live form values (preview unsaved edits); falls back to the document.
    values = serializers.DictField(required=False)
    # Inline journal mapping (builder preview); falls back to template/document.
    mapping = serializers.DictField(required=False)
    # Journal posting stage (1 = request/advance, 2 = retirement, etc.)
    stage = serializers.IntegerField(required=False, default=1)


class ConnectionSerializer(serializers.Serializer):
    """The admin-editable SunSystems Connect connection (all fields optional —
    blanks fall back to the SUNSYSTEMS_* env defaults)."""
    base_url = serializers.CharField(required=False, allow_blank=True)
    security_path = serializers.CharField(required=False, allow_blank=True)
    executor_path = serializers.CharField(required=False, allow_blank=True)
    username = serializers.CharField(required=False, allow_blank=True)
    password = serializers.CharField(required=False, allow_blank=True)
    business_unit = serializers.CharField(required=False, allow_blank=True)
    budget_code = serializers.CharField(required=False, allow_blank=True)
    verify_tls = serializers.BooleanField(required=False)
    clear_password = serializers.BooleanField(required=False, default=False)
