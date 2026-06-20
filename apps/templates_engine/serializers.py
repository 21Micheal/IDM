from rest_framework import serializers
from apps.accounts.serializers import UserSummarySerializer
from .models import DocumentTemplate


class DocumentTemplateSerializer(serializers.ModelSerializer):
    created_by = UserSummarySerializer(read_only=True)
    document_type_id   = serializers.SerializerMethodField()
    document_type_name = serializers.SerializerMethodField()
    document_type_code = serializers.SerializerMethodField()

    def get_document_type_id(self, obj):
        return str(obj.document_type_id) if obj.document_type_id else None

    def get_document_type_name(self, obj):
        return obj.document_type.name if obj.document_type else None

    def get_document_type_code(self, obj):
        return obj.document_type.code if obj.document_type else None

    class Meta:
        model = DocumentTemplate
        fields = [
            "id", "name", "description", "type", "kind", "category", "tags",
            "document_type", "document_type_id", "document_type_name", "document_type_code",
            "sections", "design", "placeholders",
            "file", "file_name",
            "use_count", "is_active",
            "created_by", "created_at", "updated_at",
        ]
        # is_active is server-managed (created active, soft-deleted via destroy).
        # Keeping it read-only also avoids the DRF multipart quirk where an absent
        # BooleanField is parsed as False — which previously deactivated uploads.
        read_only_fields = ["id", "use_count", "is_active", "created_by", "created_at", "updated_at"]

    def validate_sections(self, value):
        """Ensure sections is a list of dicts with required keys."""
        if not isinstance(value, list):
            raise serializers.ValidationError("sections must be a list.")
        for i, section in enumerate(value):
            if not isinstance(section, dict):
                raise serializers.ValidationError(f"Section {i} must be an object.")
            if "id" not in section or "title" not in section:
                raise serializers.ValidationError(f"Section {i} must have 'id' and 'title'.")
            fields = section.get("fields", [])
            if not isinstance(fields, list):
                raise serializers.ValidationError(f"Section {i} 'fields' must be a list.")
        return value

    def validate(self, attrs):
        template_type = attrs.get("type", getattr(self.instance, "type", "built"))
        template_kind = attrs.get("kind", getattr(self.instance, "kind", "form"))
        if template_type == "built":
            if template_kind == "document":
                design = attrs.get("design", getattr(self.instance, "design", {})) or {}
                if not design.get("blocks"):
                    raise serializers.ValidationError(
                        {"design": "Add at least one block to the document layout."}
                    )
            elif not attrs.get("sections", getattr(self.instance, "sections", [])):
                raise serializers.ValidationError({"sections": "At least one section is required."})
        if not attrs.get("document_type", getattr(self.instance, "document_type", None)):
            raise serializers.ValidationError({"document_type": "Select the document type this template belongs to."})
        return attrs
