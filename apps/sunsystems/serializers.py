from rest_framework import serializers

from .models import JournalPosting, PaymentRun, PaymentRunApproval


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


class PaymentRunSerializer(serializers.ModelSerializer):
    submitted_by_name = serializers.SerializerMethodField()
    processed_by_name = serializers.SerializerMethodField()
    approval_count = serializers.IntegerField(read_only=True)
    approvals = PaymentRunApprovalSerializer(many=True, read_only=True)

    class Meta:
        model = PaymentRun
        fields = [
            "id", "payment_reference", "reference_prefix", "run_date",
            "daily_sequence", "business_unit", "budget_code", "status",
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
