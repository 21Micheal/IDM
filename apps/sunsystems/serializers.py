from rest_framework import serializers

from .models import JournalPosting


class JournalPostingSerializer(serializers.ModelSerializer):
    document_id = serializers.UUIDField(source="document.id", read_only=True)
    posted_by_name = serializers.SerializerMethodField()

    class Meta:
        model = JournalPosting
        fields = [
            "id", "document_id", "status", "attempts",
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
